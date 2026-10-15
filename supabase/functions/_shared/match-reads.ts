// The read projections of Rachas v1 (docs/25 section 8.1), served by the
// groups gateway with the verified actor context, like get_group_members. The
// matches table has no client privilege at all (review of #70, P1-1), so these
// RPCs are the only way to read a match, and each one refuses a revoked
// session. None spends an idempotency key: they change nothing.
import {
  GatewayError,
  defaultMessage,
  fromDatabaseError,
  httpStatusFor,
  validation,
  type ErrorCode,
} from './errors.ts';
import type { ActorContext } from './gateway.ts';

export const MATCH_READ_OPERATIONS = ['get_match', 'list_my_matches'] as const;
export type MatchReadOperation = (typeof MATCH_READ_OPERATIONS)[number];
export function isMatchReadOperation(value: string): value is MatchReadOperation {
  return (MATCH_READ_OPERATIONS as readonly string[]).includes(value);
}

export interface MatchReadDependencies {
  readonly actor: ActorContext;
  readonly callRpc: (
    name: string,
    parameters: Record<string, unknown>,
  ) => Promise<{
    data?: unknown;
    error?: { message?: string | null; code?: string | null } | null;
  }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALLOWED: Record<MatchReadOperation, readonly string[]> = {
  get_match: ['match_id'],
  list_my_matches: [],
};

function failure(code: ErrorCode, requestId: string, fields?: Record<string, string>) {
  return {
    status: httpStatusFor(code),
    body: {
      error: { code, message: defaultMessage(code), ...(fields === undefined ? {} : { fields }) },
      request_id: requestId,
    },
  };
}

export async function dispatchMatchRead(
  deps: MatchReadDependencies,
  operation: MatchReadOperation,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const requestId = crypto.randomUUID();
  try {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw validation('body', 'must be an object');
    }
    const input = body as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!ALLOWED[operation].includes(key)) throw validation(key, 'unknown key');
    }
    const parameters: Record<string, unknown> = {
      p_actor_auth_user_id: deps.actor.authUserId,
      p_actor_session_id: deps.actor.sessionId,
    };
    if (operation === 'get_match') {
      const matchId = input['match_id'];
      if (typeof matchId !== 'string' || !UUID.test(matchId)) {
        throw validation('match_id', 'must be a canonical lowercase UUID');
      }
      parameters['p_match_id'] = matchId;
    }
    const result = await deps.callRpc(operation, parameters);
    if (result.error !== undefined && result.error !== null) throw fromDatabaseError(result.error);
    return { status: 200, body: { data: result.data, request_id: requestId } };
  } catch (thrown) {
    if (thrown instanceof GatewayError) return failure(thrown.code, requestId, thrown.fields);
    return failure('INTERNAL', requestId);
  }
}
