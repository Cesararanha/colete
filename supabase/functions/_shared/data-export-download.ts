import { defaultMessage, httpStatusFor, isErrorCode } from './errors.ts';
import type { ErrorCode } from './errors.ts';

export interface VerifiedExportActor {
  authUserId: string;
  sessionId: string;
}

export interface ExportDownloadDependencies {
  verifyToken(
    token: string,
  ): Promise<{ authUserId: string; claims: Record<string, unknown> } | undefined>;
  consume(input: {
    actorAuthUserId: string;
    actorSessionId: string;
    exportId: string;
  }): Promise<{ storage_path: string; content_digest: string }>;
  openObject(storagePath: string): Promise<Response | undefined>;
  enqueuePurge(exportId: string): Promise<void>;
  nowSeconds?: () => number;
}

function responseError(code: ErrorCode): Response {
  return new Response(JSON.stringify({ error: { code, message: defaultMessage(code) } }), {
    status: httpStatusFor(code),
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const ELIGIBLE_REAUTH_METHODS = new Set(['password', 'otp', 'totp', 'webauthn', 'sso', 'oauth']);

export function hasRecentReauthentication(
  claims: Record<string, unknown>,
  nowSeconds: number,
  windowSeconds = 300,
): boolean {
  const amr = claims['amr'];
  if (!Array.isArray(amr)) return false;
  return amr.some((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const method = (item as Record<string, unknown>)['method'];
    const timestamp = (item as Record<string, unknown>)['timestamp'];
    return (
      typeof method === 'string' &&
      ELIGIBLE_REAUTH_METHODS.has(method) &&
      typeof timestamp === 'number' &&
      Number.isInteger(timestamp) &&
      timestamp <= nowSeconds &&
      nowSeconds - timestamp <= windowSeconds
    );
  });
}

export function exportDownloadHeaders(exportId: string): Headers {
  return new Headers({
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="colete-${exportId}.zip"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
}

export function isDirectZipObject(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return (
    response.ok &&
    response.body !== null &&
    contentType === 'application/zip' &&
    !response.headers.has('location')
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function handleDataExportDownload(
  request: Request,
  dependencies: ExportDownloadDependencies,
): Promise<Response> {
  if (request.method !== 'GET') return responseError('VALIDATION');
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const contentIndex = segments.lastIndexOf('content');
  const exportId = contentIndex > 0 ? segments[contentIndex - 1] : undefined;
  if (exportId === undefined || !UUID.test(exportId)) return responseError('NOT_FOUND');
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (token.length === 0) return responseError('UNAUTHENTICATED');
  const verified = await dependencies.verifyToken(token);
  const sessionId = verified?.claims['session_id'];
  if (verified === undefined || typeof sessionId !== 'string')
    return responseError('UNAUTHENTICATED');
  if (verified.claims['aud'] !== 'authenticated') return responseError('UNAUTHENTICATED');
  if (
    !hasRecentReauthentication(
      verified.claims,
      dependencies.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
    )
  )
    return responseError('RECENT_REAUTH_REQUIRED');
  let consumed: { storage_path: string; content_digest: string };
  try {
    consumed = await dependencies.consume({
      actorAuthUserId: verified.authUserId,
      actorSessionId: sessionId,
      exportId,
    });
  } catch (error) {
    const code = error instanceof Error && isErrorCode(error.message) ? error.message : 'INTERNAL';
    return responseError(code);
  }
  const enqueue = () => dependencies.enqueuePurge(exportId);
  const object = await dependencies.openObject(consumed.storage_path);
  if (object === undefined || !isDirectZipObject(object)) {
    await enqueue().catch(() => undefined);
    return responseError('EXPORT_EXPIRED');
  }
  return new Response(purgeAfterStream(object.body, enqueue), {
    status: 200,
    headers: exportDownloadHeaders(exportId),
  });
}

export function purgeAfterStream(
  source: ReadableStream<Uint8Array>,
  enqueuePurge: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let closed = false;
  const closeAndPurge = async () => {
    if (closed) return;
    closed = true;
    try {
      await reader.cancel();
    } catch {
      /* the provider reader may already be closed */
    }
    try {
      await enqueuePurge();
    } catch {
      /* hourly reconciliation is the second barrier */
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await closeAndPurge();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        await closeAndPurge();
        controller.error(error);
      }
    },
    async cancel() {
      await closeAndPurge();
    },
  });
}
