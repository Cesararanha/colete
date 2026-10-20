// The rating reads of the pilot's simple rating (docs/13 section 4.1.2,
// 0031), served by the groups gateway with the verified actor context, like
// get_group_members. The rating tables have no client privilege at all, so
// these RPCs are the only way to read a rating, and each one refuses a
// revoked session. None spends an idempotency key: they change nothing.
import {
  GatewayError,
  defaultMessage,
  fromDatabaseError,
  httpStatusFor,
  validation,
  type ErrorCode,
} from './errors.ts';
import type { ActorContext } from './gateway.ts';

export const RATING_READ_OPERATIONS = ['get_group_ratings', 'get_my_rating'] as const;
export type RatingReadOperation = (typeof RATING_READ_OPERATIONS)[number];
export function isRatingReadOperation(value: string): value is RatingReadOperation {
  return (RATING_READ_OPERATIONS as readonly string[]).includes(value);
}

export interface RatingReadDependencies {
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

function failure(code: ErrorCode, requestId: string, fields?: Record<string, string>) {
  return {
    status: httpStatusFor(code),
    body: {
      error: { code, message: defaultMessage(code), ...(fields === undefined ? {} : { fields }) },
      request_id: requestId,
    },
  };
}

/** Both reads take the group alone; the actor comes only from the verified claims. */
export async function dispatchRatingRead(
  deps: RatingReadDependencies,
  operation: RatingReadOperation,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const requestId = crypto.randomUUID();
  try {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw validation('body', 'must be an object');
    }
    const input = body as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (key !== 'group_id') throw validation(key, 'unknown key');
    }
    const groupId = input['group_id'];
    if (typeof groupId !== 'string' || !UUID.test(groupId)) {
      throw validation('group_id', 'must be a canonical lowercase UUID');
    }
    const result = await deps.callRpc(operation, {
      p_actor_auth_user_id: deps.actor.authUserId,
      p_actor_session_id: deps.actor.sessionId,
      p_group_id: groupId,
    });
    if (result.error !== undefined && result.error !== null) throw fromDatabaseError(result.error);
    return { status: 200, body: { data: result.data, request_id: requestId } };
  } catch (thrown) {
    if (thrown instanceof GatewayError) return failure(thrown.code, requestId, thrown.fields);
    return failure('INTERNAL', requestId);
  }
}
