// Scheduled worker entry point from docs/22 section 3. Cron only wakes a named
// job. The database derives the slot and all effect identifiers; the body is
// deliberately ignored.

import {
  isWorkerJob,
  providerHttpError,
  runScheduledJob,
  timingSafeEqualText,
} from '../_shared/worker.ts';
import { accountDeletionHandlers } from '../_shared/deletion.ts';
import type {
  BegunJob,
  ExternalEffect,
  ExternalEffectKind,
  JobSummary,
  WorkerRpc,
} from '../_shared/worker.ts';
import type { DeletionEffectTarget, DeletionRpc } from '../_shared/deletion.ts';
import { dataExportBuildHandler } from '../_shared/data-export.ts';
import type { ExportBuildTarget, ExportRpc } from '../_shared/data-export.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve: (handler: (request: Request) => Promise<Response>) => unknown;
};

const readEnv = (name: string): string | undefined => Deno.env.get(name);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function rpcCall<T>(
  supabaseUrl: string,
  secretKey: string,
  functionName: string,
  params: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error('WORKER_RPC_FAILED');
  return (await response.json()) as T;
}

function databaseRpc(supabaseUrl: string, secretKey: string): WorkerRpc {
  return {
    beginJob: (job) =>
      rpcCall<BegunJob>(supabaseUrl, secretKey, 'worker_begin_job', { p_job_name: job }),
    executeDatabaseJob: (runId) =>
      rpcCall<JobSummary>(supabaseUrl, secretKey, 'worker_execute_database_job', {
        p_run_id: runId,
      }),
    acquireEffect: (supportedKinds) =>
      rpcCall<ExternalEffect | null>(supabaseUrl, secretKey, 'worker_acquire_external_effect', {
        p_supported_kinds: supportedKinds,
      }),
    completeEffect: async (effectId, leaseToken, result, errorCode) => {
      await rpcCall(supabaseUrl, secretKey, 'worker_complete_external_effect', {
        p_effect_id: effectId,
        p_lease_token: leaseToken,
        p_result: result,
        p_error_code: errorCode,
      });
    },
    finishJob: async (runId, status, summary, errorCode) => {
      await rpcCall(supabaseUrl, secretKey, 'worker_finish_job', {
        p_run_id: runId,
        p_status: status,
        p_summary: summary,
        p_error_code: errorCode,
      });
    },
  };
}

function deletionRpc(supabaseUrl: string, secretKey: string): DeletionRpc {
  return {
    getTarget: (effectId, leaseToken) =>
      rpcCall<DeletionEffectTarget>(supabaseUrl, secretKey, 'worker_get_deletion_effect_target', {
        p_effect_id: effectId,
        p_lease_token: leaseToken,
      }),
    confirmEffect: async (effectId, leaseToken) => {
      await rpcCall(supabaseUrl, secretKey, 'worker_confirm_deletion_effect', {
        p_effect_id: effectId,
        p_lease_token: leaseToken,
      });
    },
    finalizeDeletion: async (requestId) => {
      await rpcCall(supabaseUrl, secretKey, 'finalize_deletion', { p_request_id: requestId });
    },
  };
}

function exportRpc(supabaseUrl: string, secretKey: string): ExportRpc {
  return {
    getBuildTarget: (effectId, leaseToken) =>
      rpcCall<ExportBuildTarget>(supabaseUrl, secretKey, 'worker_get_data_export_build_target', {
        p_effect_id: effectId,
        p_lease_token: leaseToken,
      }),
    publish: async (effectId, leaseToken, path, digest) => {
      await rpcCall(supabaseUrl, secretKey, 'worker_publish_data_export', {
        p_effect_id: effectId,
        p_lease_token: leaseToken,
        p_storage_path: path,
        p_content_digest: digest,
      });
    },
    enqueuePurge: async (exportId) => {
      await rpcCall(supabaseUrl, secretKey, 'enqueue_data_export_purge', {
        p_export_id: exportId,
      });
    },
  };
}

function providerHeaders(secretKey: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: secretKey };
  // Legacy service_role keys are JWTs and belong in both headers. Modern
  // sb_secret keys authenticate through apikey; sending one as Bearer makes
  // Storage/Auth try to parse a non-JWT compact token.
  if (!secretKey.startsWith('sb_secret_')) {
    headers.Authorization = `Bearer ${secretKey}`;
  }
  return headers;
}

function encodedObjectPath(bucket: string, path: string): string {
  return [bucket, ...path.split('/')].map(encodeURIComponent).join('/');
}

function deletionProviders(supabaseUrl: string, secretKey: string) {
  const headers = providerHeaders(secretKey);
  return {
    storage: {
      exists: async (bucket: string, path: string) => {
        const response = await fetch(
          `${supabaseUrl}/storage/v1/object/${encodedObjectPath(bucket, path)}`,
          { method: 'HEAD', headers },
        );
        if (response.status === 404) return false;
        if (response.ok) return true;
        throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
      },
      remove: async (bucket: string, path: string) => {
        const response = await fetch(
          `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`,
          {
            method: 'DELETE',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ prefixes: [path] }),
          },
        );
        if (!response.ok && response.status !== 404) {
          throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
        }
      },
    },
    auth: {
      exists: async (authUserId: string) => {
        const response = await fetch(
          `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`,
          { headers },
        );
        if (response.status === 404) return false;
        if (response.ok) return true;
        throw providerHttpError('AUTH_UNAVAILABLE', response.status);
      },
      remove: async (authUserId: string) => {
        const response = await fetch(
          `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`,
          { method: 'DELETE', headers },
        );
        if (!response.ok && response.status !== 404) {
          throw providerHttpError('AUTH_UNAVAILABLE', response.status);
        }
      },
    },
  };
}

function exportProviders(supabaseUrl: string, secretKey: string) {
  const headers = providerHeaders(secretKey);
  const objectUrl = (path: string) =>
    `${supabaseUrl}/storage/v1/object/${encodedObjectPath('data-exports', path)}`;
  return {
    storage: {
      read: async (path: string) => {
        const response = await fetch(objectUrl(path), { headers });
        if (response.status === 404) return null;
        if (!response.ok) throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
        return new Uint8Array(await response.arrayBuffer());
      },
      upload: async (path: string, bytes: Uint8Array) => {
        const response = await fetch(objectUrl(path), {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/zip',
            'cache-control': 'no-store',
            'x-upsert': 'false',
          },
          body: bytes,
        });
        if (!response.ok) throw providerHttpError('STORAGE_UPLOAD_FAILED', response.status);
      },
      remove: async (path: string) => {
        const response = await fetch(`${supabaseUrl}/storage/v1/object/data-exports`, {
          method: 'DELETE',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ prefixes: [path] }),
        });
        if (!response.ok && response.status !== 404) {
          throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
        }
      },
    },
    auth: {
      projection: async (authUserId: string) => {
        const response = await fetch(
          `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`,
          { headers },
        );
        if (!response.ok) throw providerHttpError('AUTH_UNAVAILABLE', response.status);
        const user = (await response.json()) as {
          email_confirmed_at?: unknown;
          identities?: Array<{ provider?: unknown }>;
        };
        const providers = [
          ...new Set(
            (user.identities ?? [])
              .map((identity) => identity.provider)
              .filter((provider): provider is string => typeof provider === 'string'),
          ),
        ].sort();
        const raw = user as typeof user & { email?: unknown };
        return {
          email:
            typeof user.email_confirmed_at === 'string' && typeof raw.email === 'string'
              ? raw.email
              : null,
          providers,
        };
      },
    },
  };
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'METHOD_NOT_ALLOWED' });

  const segments = new URL(request.url).pathname.split('/').filter((segment) => segment.length > 0);
  const jobName = segments[segments.length - 1] ?? '';
  if (!isWorkerJob(jobName)) return jsonResponse(404, { error: 'NOT_FOUND' });

  const expectedSecret = readEnv('WORKER_CRON_SECRET');
  const authorization = request.headers.get('Authorization') ?? '';
  const receivedSecret = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
  if (
    expectedSecret === undefined ||
    expectedSecret.length === 0 ||
    !timingSafeEqualText(expectedSecret, receivedSecret)
  ) {
    return jsonResponse(401, { error: 'UNAUTHENTICATED' });
  }

  const supabaseUrl = readEnv('SUPABASE_URL');
  const serviceRoleJwt = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  const secretKey = readEnv('SUPABASE_SECRET_KEY') ?? serviceRoleJwt;
  if (supabaseUrl === undefined || secretKey === undefined) {
    return jsonResponse(500, { error: 'INTERNAL' });
  }

  const rpc = databaseRpc(supabaseUrl, secretKey);
  const handlers = accountDeletionHandlers(
    deletionRpc(supabaseUrl, secretKey),
    // Self-hosted/local Storage versions may predate sb_secret support even
    // while PostgREST accepts it. Prefer the legacy service-role JWT for the
    // provider APIs when the platform supplies both credentials.
    deletionProviders(supabaseUrl, serviceRoleJwt ?? secretKey),
  );
  const exportDependencies = exportProviders(supabaseUrl, serviceRoleJwt ?? secretKey);
  handlers.build_data_export = dataExportBuildHandler(
    exportRpc(supabaseUrl, secretKey),
    exportDependencies.storage,
    exportDependencies.auth,
  );
  const result = await runScheduledJob(
    {
      rpc,
      handlers,
      healthAlert: (code) => console.error(code),
    },
    jobName,
  );
  return jsonResponse(result === 'failed' ? 500 : 200, { data: { status: result } });
});

export type { ExternalEffectKind };
