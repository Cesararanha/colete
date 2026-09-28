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

import { runOperation, requestIdHintFrom } from './gateway.ts';
import type { ActorContext, RpcCaller } from './gateway.ts';
import { keyResolverFromEnvironment } from './hmac.ts';
import type { Operation } from './operations.ts';
import { GatewayError, defaultMessage, httpStatusFor } from './errors.ts';
import type { ErrorCode } from './errors.ts';

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
export function serveGateway(served: readonly Operation[]): void {
  const SUPABASE_URL = requireEnv('SUPABASE_URL');
  // The client-facing key, used only to address the Auth endpoint that verifies
  // the caller's token.
  const PUBLISHABLE_KEY = requireEnv('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY');
  // The elevated key. It stays in this process: never in a bundle, a browser, a
  // URL or a log, per docs/14 section 5.
  const SECRET_KEY = requireEnv('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');

  const resolveKey = keyResolverFromEnvironment(readEnv, [1]);

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
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
      };
      return { error: { message: failure.message ?? null } };
    }
    return { data: await response.json() };
  };

  Deno.serve(async (request: Request): Promise<Response> => {
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

    const result = await runOperation(
      { resolveKey, callRpc },
      operation,
      body,
      actor,
      requestIdHint,
    );
    return jsonResponse(result.status, result.body);
  });
}

export { GatewayError };
