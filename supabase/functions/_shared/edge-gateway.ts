// The exclusive gateway of docs/13-contratos-funcoes.md section 0 and
// docs/14-convencoes-app.md section 5.3, shared by the Edge Functions that
// serve mutations. Each function serves only its own closed list of
// operations: identity and privacy in `identity`, group membership in
// `groups`. An operation outside the list answers NOT_FOUND, so no function
// becomes a second door to another domain.
//
// There are no third-party imports on purpose. Verifying a token and calling a
// narrow RPC are two HTTP requests, and pulling a client library in to make
// them would add a bundle-time network fetch to every cold start and to every
// CI run, plus a dependency this gateway does not otherwise need.
//
// Two boundaries meet in this file and must not blur:
//   external  client -> Edge : request_id plus business fields, nothing else.
//   internal  Edge -> RPC    : normalised input, request_id, the actor taken
//                              from verified claims, input_hmac, key version.
// The secret key authenticates this component, not the person. That is why the
// actor travels as an explicit argument and the RPC revalidates everything.

import { withBrowserCors } from './browser-cors.ts';

import { runOperation, requestIdHintFrom } from './gateway.ts';
import type { ActorContext, RpcCaller } from './gateway.ts';
import { keyResolverFromEnvironment } from './hmac.ts';
import type { Operation } from './operations.ts';
import { GatewayError, defaultMessage, httpStatusFor } from './errors.ts';
import {
  dispatchInvite,
  inviteKeyFromEnvironment,
  inviteShareUrl,
  isInviteOperation,
} from './invite-gateway.ts';
import type { ErrorCode } from './errors.ts';
import { dispatchMatchRead, isMatchReadOperation } from './match-reads.ts';
import { DEFAULT_USER_AGENT, dispatchGeocode, isGeocodeOperation } from './geocode.ts';
import { dispatchPhoto, isPhotoOperation } from './photo-gateway.ts';
import { createPhotoStorage } from './photo-storage.ts';
import { dispatchRatingRead, isRatingReadOperation } from './rating-reads.ts';
import { dispatchPixRead, isPixReadOperation } from './pix-reads.ts';
import { pixKeyFromEnvironment, pixOpener, pixSealer } from './pix.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve: (handler: (request: Request) => Promise<Response>) => unknown;
};

const readEnv = (name: string): string | undefined => Deno.env.get(name);

function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = readEnv(name);
    if (value !== undefined && value.length > 0) return value;
  }
  throw new Error(`missing environment variable: ${names.join(' or ')}`);
}

/** Serves exactly the operations in `served`, and nothing else. */
export function serveGateway(served: readonly string[]): void {
  const SUPABASE_URL = requireEnv('SUPABASE_URL');
  // The client-facing key, used only to address the Auth endpoint that verifies
  // the caller's token.
  const PUBLISHABLE_KEY = requireEnv('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY');
  // The elevated key. It stays in this process: never in a bundle, a browser, a
  // URL or a log, per docs/14 section 5.
  const SECRET_KEY = requireEnv('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');

  const resolveKey = keyResolverFromEnvironment(readEnv, [1]);
  // Storage versions of the local stack may predate sb_secret keys while
  // PostgREST accepts them, so the photo calls prefer the legacy service-role
  // JWT when the platform supplies both, as the worker does.
  const photoStorage = createPhotoStorage(
    SUPABASE_URL,
    readEnv('SUPABASE_SERVICE_ROLE_KEY') ?? SECRET_KEY,
  );

  function jsonResponse(status: number, body: unknown): Response {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    };
    const error = (body as { error?: { code?: string; retry_after?: number } }).error;
    if (error?.code === 'RATE_LIMITED' && Number.isInteger(error.retry_after)) {
      headers['retry-after'] = String(error.retry_after);
    }
    return new Response(JSON.stringify(body), { status, headers });
  }

  function errorResponse(code: ErrorCode, requestId: string): Response {
    return jsonResponse(httpStatusFor(code), {
      error: { code, message: defaultMessage(code) },
      request_id: requestId,
    });
  }

  /** The session_id claim of an already verified token. */
  function sessionIdFromVerifiedToken(token: string): string | undefined {
    const segments = token.split('.');
    const payload = segments[1];
    if (segments.length !== 3 || payload === undefined) return undefined;
    try {
      const padded = payload.replaceAll('-', '+').replaceAll('_', '/');
      const decoded = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
      const claims = JSON.parse(decoded) as Record<string, unknown>;
      const sessionId = claims['session_id'];
      return typeof sessionId === 'string' ? sessionId : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Verifies the caller's token against Auth and returns the actor. A token that
   * carries no session_id is refused: docs/13 section 5.5 makes an unidentifiable
   * session a denial, because its revocation cannot be checked.
   */
  async function verifyActor(token: string): Promise<ActorContext | undefined> {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;

    const user = (await response.json()) as { id?: unknown };
    if (typeof user.id !== 'string') return undefined;

    const sessionId = sessionIdFromVerifiedToken(token);
    if (sessionId === undefined) return undefined;

    return { authUserId: user.id, sessionId };
  }

  // The only database access this gateway has: the served named RPCs. No generic
  // administrative endpoint, no free DML, no SQL built here.
  const callRpc: RpcCaller = async (functionName, params) => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        apikey: SECRET_KEY,
        Authorization: `Bearer ${SECRET_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as {
        message?: string | null;
        code?: string | null;
      };
      return { error: { message: failure.message ?? null, code: failure.code ?? null } };
    }
    return { data: await response.json() };
  };

  async function ownProfileId(token: string): Promise<string> {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id`, {
      headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new GatewayError('RATE_LIMIT_UNAVAILABLE', defaultMessage('RATE_LIMIT_UNAVAILABLE'));
    const profiles = (await response.json()) as Array<{ id?: unknown }>;
    if (!Array.isArray(profiles) || profiles.length !== 1 || typeof profiles[0]?.id !== 'string') {
      throw new GatewayError('NOT_FOUND', defaultMessage('NOT_FOUND'));
    }
    return profiles[0].id;
  }

  Deno.serve(
    withBrowserCors(
      async (request: Request): Promise<Response> => {
        if (request.method !== 'POST') {
          return errorResponse('VALIDATION', '');
        }

        const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
        const name = segments[segments.length - 1] ?? '';
        const operation = served.find((candidate) => candidate === name);
        if (operation === undefined) {
          return errorResponse('NOT_FOUND', '');
        }

        const header = request.headers.get('Authorization') ?? '';
        const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
        if (token.length === 0) {
          return errorResponse('UNAUTHENTICATED', '');
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return errorResponse('VALIDATION', '');
        }
        const requestIdHint = requestIdHintFrom(body);

        const actor = await verifyActor(token);
        if (actor === undefined) {
          return errorResponse('UNAUTHENTICATED', requestIdHint);
        }

        // The address search leaves the Edge for LocationIQ; the app never
        // calls the search service, so the app's CSP does not change.
        if (isGeocodeOperation(operation)) {
          const search = await dispatchGeocode(
            {
              actor,
              callRpc,
              fetchUpstream: (url, init) => fetch(url, init),
              apiKey: readEnv('LOCATIONIQ_API_KEY')?.trim() ?? '',
              userAgent: readEnv('GEOCODER_USER_AGENT') || DEFAULT_USER_AGENT,
              // A fixed code only, like the worker's health alert: the cause of
              // an unavailable search shows in the function log, never the
              // query, the key or the URL that carries them.
              report: (code) => console.warn(code),
            },
            body,
          );
          return jsonResponse(search.status, search.body);
        }

        if (isPhotoOperation(operation)) {
          const photo = await dispatchPhoto(
            { actor, resolveKey, callRpc, storage: photoStorage },
            operation,
            body,
          );
          return jsonResponse(photo.status, photo.body);
        }

        if (isRatingReadOperation(operation)) {
          const read = await dispatchRatingRead({ actor, callRpc }, operation, body);
          return jsonResponse(read.status, read.body);
        }

        // The Pix key is read from the environment per request, so a missing
        // or malformed secret fails only the Pix calls, never the others.
        if (isPixReadOperation(operation)) {
          const read = await dispatchPixRead(
            { actor, callRpc, openPix: () => pixOpener(pixKeyFromEnvironment(readEnv)) },
            operation,
            body,
          );
          return jsonResponse(read.status, read.body);
        }

        if (isMatchReadOperation(operation)) {
          const read = await dispatchMatchRead({ actor, callRpc }, operation, body);
          return jsonResponse(read.status, read.body);
        }

        let inviteKey: Uint8Array | undefined;
        if (isInviteOperation(operation)) {
          try {
            inviteKey = inviteKeyFromEnvironment(readEnv);
          } catch {
            return errorResponse('INTERNAL', requestIdHint);
          }
        }
        const result = isInviteOperation(operation)
          ? await dispatchInvite(
              {
                actor,
                resolveKey,
                inviteKey: inviteKey!,
                callRpc,
                profileId: () => ownProfileId(token),
                shareUrl: (inviteToken) =>
                  inviteShareUrl(
                    readEnv('INVITE_SHARE_URL_BASE'),
                    inviteToken,
                    readEnv('COLETE_LOCAL_STACK') === 'true',
                  ),
              },
              operation,
              body,
            )
          : await runOperation(
              {
                resolveKey,
                callRpc,
                sealPix: () => pixSealer(pixKeyFromEnvironment(readEnv)),
              },
              operation as Operation,
              body,
              actor,
              requestIdHint,
            );
        return jsonResponse(result.status, result.body);
      },
      readEnv,
      ['POST'],
    ),
  );
}

export { GatewayError };
