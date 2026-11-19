// get_payment_instructions (0036): the pilot cut of docs/13 section 1.3.1. It
// is not part of the generic match reads because the gateway opens the sealed
// key here; the RPC alone decides who may read. The open key leaves only in the
// success body; no failure carries the ciphertext, the key or any detail of
// the decryption (plan section 4.4).
import {
  GatewayError,
  defaultMessage,
  fromDatabaseError,
  httpStatusFor,
  validation,
  type ErrorCode,
} from './errors.ts';
import type { ActorContext } from './gateway.ts';
import { PIX_KEY_TYPES, type PixKeyType, type PixOpener } from './pix.ts';

export const PIX_READ_OPERATIONS = ['get_payment_instructions'] as const;
export type PixReadOperation = (typeof PIX_READ_OPERATIONS)[number];
export function isPixReadOperation(value: string): value is PixReadOperation {
  return (PIX_READ_OPERATIONS as readonly string[]).includes(value);
}

export interface PixReadDependencies {
  readonly actor: ActorContext;
  readonly callRpc: (
    name: string,
    parameters: Record<string, unknown>,
  ) => Promise<{
    data?: unknown;
    error?: { message?: string | null; code?: string | null } | null;
  }>;
  /** Built lazily: without PIX_KEY_ENC_KEY_V1 the read answers INTERNAL. */
  readonly openPix: () => PixOpener;
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

interface SealedInstructions {
  type: PixKeyType;
  ciphertext: string;
  key_version: number;
  receiver_name: string;
  receiver_city: string;
  amount: string;
  set_by_name: string | null;
  set_at: string;
  replaced: boolean;
}

function asSealed(data: unknown): SealedInstructions {
  const record = data as Record<string, unknown> | null;
  if (
    record === null ||
    typeof record !== 'object' ||
    !(PIX_KEY_TYPES as readonly unknown[]).includes(record['type']) ||
    typeof record['ciphertext'] !== 'string' ||
    typeof record['key_version'] !== 'number' ||
    typeof record['receiver_name'] !== 'string' ||
    typeof record['receiver_city'] !== 'string' ||
    typeof record['amount'] !== 'string' ||
    (record['set_by_name'] !== null && typeof record['set_by_name'] !== 'string') ||
    typeof record['set_at'] !== 'string' ||
    typeof record['replaced'] !== 'boolean'
  ) {
    throw new GatewayError('INTERNAL', defaultMessage('INTERNAL'));
  }
  return record as unknown as SealedInstructions;
}

export async function dispatchPixRead(
  deps: PixReadDependencies,
  _operation: PixReadOperation,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const requestId = crypto.randomUUID();
  try {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw validation('body', 'must be an object');
    }
    const input = body as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (key !== 'match_id') throw validation(key, 'unknown key');
    }
    const matchId = input['match_id'];
    if (typeof matchId !== 'string' || !UUID.test(matchId)) {
      throw validation('match_id', 'must be a canonical lowercase UUID');
    }
    const result = await deps.callRpc('get_payment_instructions', {
      p_actor_auth_user_id: deps.actor.authUserId,
      p_actor_session_id: deps.actor.sessionId,
      p_match_id: matchId,
    });
    if (result.error !== undefined && result.error !== null) throw fromDatabaseError(result.error);
    const sealed = asSealed(result.data);
    let key: string;
    try {
      key = await deps.openPix()(sealed.type, sealed.ciphertext, sealed.key_version, matchId);
    } catch {
      throw new GatewayError('INTERNAL', defaultMessage('INTERNAL'));
    }
    return {
      status: 200,
      body: {
        data: {
          type: sealed.type,
          key,
          receiver_name: sealed.receiver_name,
          receiver_city: sealed.receiver_city,
          amount: sealed.amount,
          set_by_name: sealed.set_by_name,
          set_at: sealed.set_at,
          replaced: sealed.replaced,
        },
        request_id: requestId,
      },
    };
  } catch (thrown) {
    if (thrown instanceof GatewayError) return failure(thrown.code, requestId, thrown.fields);
    return failure('INTERNAL', requestId);
  }
}
